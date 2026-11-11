/**
 * ご注文手続きフロー
 * 画面表示用のロジックと、応答記録の保存を行う。
 */
(function () {
  // 注文者ごとの入力内容（同じ難易度で2件）
  const ORDERS = [
    {
      qty: "2",
      date: "2026-10-20",
      name: "山田 花子",
      kana: "やまだ はなこ",
      zip: "1600022",
      address: "東京都新宿区新宿3-15-8 メゾン花子201",
      tel: "090-1234-5678",
      email: "hanako@example.com",
      payment: "クレジットカード",
    },
    {
      qty: "1",
      date: "2026-10-22",
      name: "佐藤 太郎",
      kana: "さとう たろう",
      zip: "1500001",
      address: "東京都渋谷区神宮前1-2-3 グランド太郎302",
      tel: "080-9876-5432",
      email: "taro.sato@example.com",
      payment: "代金引換",
    },
  ];

  // 住所補完用の参照データ（郵便番号7桁）
  // 回答の送信先（Google Apps Script の Web アプリ URL）。
  // 未設定なら送信せず、localStorage のみに保存する（従来どおり）。
  // 検証用に window.__SUBMIT_ENDPOINT があればそちらを優先する。
  const SUBMIT_ENDPOINT =
    (typeof window !== "undefined" && window.__SUBMIT_ENDPOINT) ||
    "https://script.google.com/macros/s/AKfycbxMeij8ZFGBXoW0f__rDzP6_OfWnjCQjaSaj_P6T3IVO8t304mTuNEkcP-JY-b6r-ShJA/exec";

  const ZIP_MAP = {
    "1600022": "東京都新宿区新宿3-15-8 メゾン花子201",
    "1500001": "東京都渋谷区神宮前1-2-3 グランド太郎302",
    "1000005": "東京都千代田区丸の内1-1-1 パレス太郎101",
  };

  // 表示順と入力時の挙動の組み合わせは開始時に決定する
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function isValidMode(value) {
    return value === 0 || value === 1;
  }

  function ensureSession() {
    let raw = sessionStorage.getItem("shop-session");
    if (raw) {
      try {
        const session = JSON.parse(raw);
        const modesOk =
          Array.isArray(session.modeOrder) &&
          session.modeOrder.length === 2 &&
          session.modeOrder.every(isValidMode);
        const ordersOk =
          Array.isArray(session.orderOrder) &&
          session.orderOrder.length === 2 &&
          session.orderOrder.every((n) => n === 0 || n === 1);
        if (modesOk && ordersOk) return session;
      } catch (_) {
        /* rebuild below */
      }
    }

    const modeOrder = shuffle([0, 1]);
    const orderOrder = shuffle(ORDERS.map((_, i) => i));
    const session = {
      v: 2,
      sessionId:
        "S" +
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 6),
      modeOrder,
      orderOrder,
      stepIndex: 0,
      responses: [],
      startedAt: Date.now(),
    };
    sessionStorage.setItem("shop-session", JSON.stringify(session));
    return session;
  }

  function saveSession(session) {
    sessionStorage.setItem("shop-session", JSON.stringify(session));
  }

  // 注文が完了するたびに送信先へ送る（ベストエフォート）。
  // 失敗しても実験は続行する。localStorage 側が正本で、後から書き出して回収できる。
  function sendResponse(response) {
    if (!SUBMIT_ENDPOINT) return;
    try {
      fetch(SUBMIT_ENDPOINT, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(response),
      }).catch(() => {});
    } catch (e) {
      /* 送信できなくても何もしない */
    }
  }

  function briefHtml(order) {
    const rows = [
      ["数量", order.qty],
      ["希望配送日", order.date],
      ["氏名", order.name],
      ["ふりがな", order.kana],
      ["郵便番号", order.zip],
      ["住所", order.address],
      ["電話番号", order.tel],
      ["メールアドレス", order.email],
      ["支払い方法", order.payment],
    ];
    return rows
      .map(
        ([k, v]) =>
          `<p class="brief-line"><span>${k}</span>${v}</p>`
      )
      .join("");
  }

  // ---- 注文情報パネル（v3で追加） ----
  // 注文情報を項目別の開閉パネルで提示し、開閉をログに残す。
  // 全項目を同じ作りにし、住所だけを特別扱いしない（照合への誘導を避ける）。
  const PANEL_FIELDS = [
    ["qty", "数量"],
    ["date", "希望配送日"],
    ["name", "氏名"],
    ["kana", "ふりがな"],
    ["zip", "郵便番号"],
    ["address", "住所"],
    ["tel", "電話番号"],
    ["email", "メールアドレス"],
    ["payment", "支払い方法"],
  ];

  function panelsHtml(order) {
    return (
      '<div class="info-panels">' +
      PANEL_FIELDS.map(
        ([key, label]) =>
          `<div class="info-panel" data-panel="${key}">` +
          `<button type="button" class="info-panel-head" aria-expanded="false">${label}<span class="info-panel-mark">＋</span></button>` +
          `<div class="info-panel-body hidden">${order[key]}</div>` +
          `</div>`
      ).join("") +
      "</div>"
    );
  }

  // パネルの開閉セッション（panelStats の集計用に保持する）
  let panelSessions = [];
  let panelOpenSince = {};
  // 項目ごとの「値が確定した時刻」（住所は check 側で追うため対象外）
  let fieldSettledAt = {};

  function resetPanels() {
    panelSessions = [];
    panelOpenSince = {};
    fieldSettledAt = {};
  }

  function settledTimeFor(key, mode) {
    if (key === "address") {
      if (!check) return null;
      // 自動入力条件では発動時刻、手入力条件では入力して欄を離れた時刻を基準にする
      return mode === 1 ? check.valueSetAt : check.settledAt;
    }
    return fieldSettledAt[key] || null;
  }

  function computePanelStats(startedAt, mode) {
    // 送信時点で開いたままのパネルは、送信時刻で閉じたものとして集計する
    const now = Date.now();
    Object.keys(panelOpenSince).forEach((name) => {
      panelSessions.push({ name, openAt: panelOpenSince[name], closeAt: now });
    });
    panelOpenSince = {};
    const stats = {};
    PANEL_FIELDS.forEach(([key]) => {
      const sessions = panelSessions.filter((s) => s.name === key);
      const settled = settledTimeFor(key, mode);
      let totalDwellMs = 0;
      let reopenCount = 0;
      let reopenDwellMs = 0;
      sessions.forEach((s) => {
        const dwell = s.closeAt - s.openAt;
        totalDwellMs += dwell;
        // 再オープン = 値が確定した後のオープン（滞在300ms未満は誤操作として数えない）
        if (settled && s.openAt > settled && dwell >= 300) {
          reopenCount += 1;
          reopenDwellMs += dwell;
        }
      });
      stats[key] = {
        opens: sessions.length,
        totalDwellMs,
        firstOpenOffsetMs: sessions.length ? sessions[0].openAt - startedAt : null,
        reopenCount,
        reopenDwellMs,
      };
    });
    return stats;
  }

  function onPanelToggle(e) {
    const head = e.currentTarget;
    const panel = head.closest(".info-panel");
    if (!panel) return;
    const name = panel.dataset.panel;
    const body = panel.querySelector(".info-panel-body");
    const now = Date.now();
    const opening = body.classList.contains("hidden");
    body.classList.toggle("hidden", !opening);
    head.setAttribute("aria-expanded", String(opening));
    const mark = panel.querySelector(".info-panel-mark");
    if (mark) mark.textContent = opening ? "－" : "＋";
    if (opening) {
      panelOpenSince[name] = now;
      logEvent("panel-open", name);
    } else {
      if (panelOpenSince[name]) {
        panelSessions.push({ name, openAt: panelOpenSince[name], closeAt: now });
        delete panelOpenSince[name];
      }
      logEvent("panel-close", name);
    }
  }

  function bindPanels() {
    document
      .querySelectorAll("#order-brief .info-panel-head")
      .forEach((btn) => btn.addEventListener("click", onPanelToggle));
  }

  function showView(id) {
    ["view-welcome", "view-task", "view-between", "view-done"].forEach((vid) => {
      const el = document.getElementById(vid);
      if (el) el.classList.toggle("hidden", vid !== id);
    });
    window.scrollTo(0, 0);
  }

  function currentOrder(session) {
    return ORDERS[session.orderOrder[session.stepIndex]];
  }

  function currentMode(session) {
    return session.modeOrder[session.stepIndex];
  }

  function shouldAssist(session) {
    return currentMode(session) === 1;
  }

  // ---- 住所の自動入力（mode 1 のときのみ有効） ----
  const form = document.getElementById("order-form");
  const zipInput = document.getElementById("zip");
  const addressInput = document.getElementById("address");

  let review = {
    assist: false,
    fillAt: null,
    filledValue: null,
    focusAfter: 0,
    editAfter: 0,
  };

  // ---- 見直し行動の共通計測（v2で追加。自動入力の有無にかかわらず両条件で数える） ----
  // 定義: 住所に値が入ったあと、いったん住所欄を離れた（settled）後の
  // 住所欄への再フォーカスを「見直し」、settled後の編集を「見直しに伴う修正」とする。
  // 自動入力条件では、値が入った状態での住所欄への初回フォーカス自体を見直しとして数える
  // （手入力条件の初回フォーカスは値が入る前に起きるため、同じルールで混ざらない）。
  let check = null;

  function resetCheck() {
    check = {
      valueSetAt: null,
      settledAt: null,
      focusReturn: 0,
      editAfterSettle: 0,
      firstCheckAt: null,
    };
  }
  resetCheck();

  function markSettled() {
    if (check && check.valueSetAt && !check.settledAt) {
      check.settledAt = Date.now();
    }
  }

  function logEvent(type, name, extra) {
    const session = ensureSession();
    session.events = session.events || [];
    const ev = { t: Date.now() - (session.stepStartedAt || Date.now()), type };
    if (name) ev.name = name;
    if (extra) Object.assign(ev, extra);
    session.events.push(ev);
    saveSession(session);
  }

  function normalizeZip(raw) {
    return String(raw || "").replace(/[^\d]/g, "").slice(0, 7);
  }

  function tryFillAddress() {
    const digits = normalizeZip(zipInput.value);
    if (zipInput.value !== digits) zipInput.value = digits;
    const filled = ZIP_MAP[digits];
    if (digits.length === 7 && filled) {
      if (addressInput.value !== filled) {
        addressInput.value = filled;
        review.fillAt = Date.now();
        review.filledValue = filled;
        if (check && !check.valueSetAt) check.valueSetAt = review.fillAt;
      } else if (!review.fillAt) {
        review.fillAt = Date.now();
        review.filledValue = filled;
      }
      return true;
    }
    return false;
  }

  function onZipInput() {
    tryFillAddress();
  }

  function onFocusAddress() {
    if (review.fillAt) review.focusAfter += 1;
  }

  function onInputAddress() {
    if (review.fillAt && addressInput.value !== review.filledValue) {
      review.editAfter += 1;
    }
  }

  function bindAssist(enabled) {
    zipInput.removeEventListener("input", onZipInput);
    zipInput.removeEventListener("change", onZipInput);
    addressInput.removeEventListener("focus", onFocusAddress);
    addressInput.removeEventListener("input", onInputAddress);

    review = {
      assist: !!enabled,
      fillAt: null,
      filledValue: null,
      focusAfter: 0,
      editAfter: 0,
    };
    resetCheck();

    if (enabled) {
      zipInput.addEventListener("input", onZipInput);
      zipInput.addEventListener("change", onZipInput);
      addressInput.addEventListener("focus", onFocusAddress);
      addressInput.addEventListener("input", onInputAddress);
    }
  }

  function resetForm(order) {
    form.reset();
    form.querySelectorAll(".field").forEach((el) => el.classList.remove("invalid"));
    document.getElementById("qty").value = order.qty;
    document.getElementById("date").value = order.date;
    // 氏名などは空欄のまま（タスクどおり入力してもらう）
  }

  let lastInvalidFields = [];

  function validate() {
    let ok = true;
    lastInvalidFields = [];
    const required = [
      "qty", "date", "name", "kana", "zip", "address", "tel", "email", "payment",
    ];
    required.forEach((name) => {
      const el = form.elements[name];
      let value = el && "value" in el ? String(el.value || "").trim() : "";
      if (name === "payment") {
        value = form.querySelector('input[name="payment"]:checked')?.value || "";
      }
      const field = form.querySelector(`[data-field="${name}"]`);
      if (!value) {
        if (field) field.classList.add("invalid");
        lastInvalidFields.push(name);
        ok = false;
      } else if (field) {
        field.classList.remove("invalid");
      }
    });

    const email = String(form.elements.email?.value || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      form.querySelector('[data-field="email"]')?.classList.add("invalid");
      if (!lastInvalidFields.includes("email")) lastInvalidFields.push("email");
      ok = false;
    }
    const tel = String(form.elements.tel?.value || "").replace(/[^\d]/g, "");
    if (tel && tel.length < 10) {
      form.querySelector('[data-field="tel"]')?.classList.add("invalid");
      if (!lastInvalidFields.includes("tel")) lastInvalidFields.push("tel");
      ok = false;
    }
    return ok;
  }

  function startTask() {
    const session = ensureSession();
    const order = currentOrder(session);

    document.getElementById("order-brief").innerHTML = panelsHtml(order);
    bindPanels();
    resetPanels();
    document.getElementById("task-lead").textContent =
      "必要事項をご入力のうえ、「注文する」へお進みください。";
    resetForm(order);
    bindAssist(shouldAssist(session));
    session.stepStartedAt = Date.now();
    session.events = [];
    session.submitAttempts = 0;
    saveSession(session);
    showView("view-task");
  }

  form.addEventListener("input", (e) => {
    const t = e.target;
    if (t && t.name) {
      logEvent("input", t.name);
      if (t.name === "address" && check) {
        if (!check.valueSetAt && addressInput.value.trim()) {
          check.valueSetAt = Date.now();
        }
        if (check.settledAt) check.editAfterSettle += 1;
      }
    }
  });

  form.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!t || !t.name) return;
    logEvent("focus", t.name);
    if (t.name === "address") {
      // 値が入った状態での住所欄へのフォーカスは見直しとして数える（両条件共通）
      if (check && check.valueSetAt) {
        check.focusReturn += 1;
        if (!check.firstCheckAt) check.firstCheckAt = Date.now();
        markSettled();
      }
    } else {
      // 住所以外の欄へ移った時点で、住所は「いったん入力が済んだ」状態になる
      markSettled();
    }
  });

  form.addEventListener("focusout", (e) => {
    const t = e.target;
    if (!t || !t.name) return;
    const extra =
      t.name === "address" || t.name === "zip" ? { value: t.value } : undefined;
    logEvent("blur", t.name, extra);
    if (t.name === "address" && addressInput.value.trim()) markSettled();
    // 住所以外の項目は「値が入った状態で欄を離れた時刻」を値の確定として記録する
    if (t.name !== "address" && !fieldSettledAt[t.name]) {
      const v = String(t.value || "").trim();
      if (v) {
        if (t.name === "zip") {
          if (normalizeZip(v).length === 7) fieldSettledAt.zip = Date.now();
        } else {
          fieldSettledAt[t.name] = Date.now();
        }
      }
    }
  });

  form.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.name === "payment" && t.checked && !fieldSettledAt.payment) {
      fieldSettledAt.payment = Date.now();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const session = ensureSession();
    const order = currentOrder(session);
    const mode = shouldAssist(session) ? 1 : 0;

    session.submitAttempts = (session.submitAttempts || 0) + 1;
    saveSession(session);

    if (!validate()) {
      // B層（過程の誤り）とD層（回復時間）のために、失敗した項目ごと記録する
      logEvent("submit-failed", null, { fields: lastInvalidFields.slice() });
      const first = form.querySelector(".field.invalid input, .field.invalid select");
      if (first) first.focus();
      return;
    }

    logEvent("submit-success", null);
    // logEvent は保存済みセッション側に追記するため、最新の events を取り直す
    session.events = ensureSession().events || session.events;

    const startedAt = session.stepStartedAt || Date.now();
    const toOffset = (ts) => (ts ? ts - startedAt : null);
    const response = {
      step: session.stepIndex + 1,
      mode,
      orderId: session.orderOrder[session.stepIndex],
      logVersion: 3,
      sessionId: session.sessionId || null,
      durationMs: Date.now() - startedAt,
      submitAttempts: session.submitAttempts,
      values: Object.fromEntries(new FormData(form).entries()),
      expected: order,
      review: { ...review },
      addressCheck: check
        ? {
            focusReturn: check.focusReturn,
            editAfterSettle: check.editAfterSettle,
            valueSetOffsetMs: toOffset(check.valueSetAt),
            settledOffsetMs: toOffset(check.settledAt),
            firstCheckOffsetMs: toOffset(check.firstCheckAt),
          }
        : null,
      panelStats: computePanelStats(startedAt, mode),
      events: session.events || [],
      finishedAt: new Date().toISOString(),
    };

    session.responses = session.responses || [];
    session.responses.push(response);
    saveSession(session);

    // 保存（担当者確認用。画面には出さない）
    try {
      const key = "shop-responses";
      const all = JSON.parse(localStorage.getItem(key) || "[]");
      all.push(response);
      localStorage.setItem(key, JSON.stringify(all));
    } catch (_) {
      /* noop */
    }
    sendResponse(response);

    if (session.stepIndex < 1) {
      const nextOrder = ORDERS[session.orderOrder[1]];
      document.getElementById("between-brief").innerHTML = briefHtml(nextOrder);
      showView("view-between");
    } else {
      showView("view-done");
    }
  });

  document.getElementById("btn-start").addEventListener("click", () => {
    const session = ensureSession();
    session.stepIndex = 0;
    saveSession(session);
    startTask();
  });

  document.getElementById("btn-next").addEventListener("click", () => {
    const session = ensureSession();
    session.stepIndex = 1;
    saveSession(session);
    startTask();
  });

  // 初期表示
  showView("view-welcome");
})();
