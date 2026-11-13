(function () {
  var clock = document.querySelector("[data-clock]");
  var sec = document.querySelector("[data-sec]");
  if (clock && sec) {
    var tick = function () {
      var now = new Date();
      var hh = String(now.getHours()).padStart(2, "0");
      var mm = String(now.getMinutes()).padStart(2, "0");
      var ss = String(now.getSeconds()).padStart(2, "0");
      clock.textContent = hh + ":" + mm;
      sec.textContent = ss;
    };
    tick();
    setInterval(tick, 1000);
  }

  var filter = document.querySelector("[data-filter]");
  var list = document.querySelector("[data-list]");
  if (filter && list) {
    filter.addEventListener("input", function () {
      var q = filter.value.trim().toLowerCase();
      list.querySelectorAll(".row").forEach(function (el) {
        var name = (el.textContent || "").toLowerCase();
        el.classList.toggle("hidden", q.length > 0 && name.indexOf(q) === -1);
      });
    });
  }

  document.querySelectorAll(".prow").forEach(function (row) {
    if (row.tagName !== "BUTTON") return;
    row.addEventListener("click", function () {
      var open = row.classList.contains("open");
      document.querySelectorAll(".prow.open").forEach(function (el) {
        el.classList.remove("open");
      });
      if (!open) row.classList.add("open");
    });
  });

  document.querySelectorAll("[data-tab]").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var name = tab.getAttribute("data-tab");
      document.querySelectorAll("[data-tab]").forEach(function (el) {
        el.classList.toggle("on", el === tab);
      });
      document.querySelectorAll("[data-group]").forEach(function (el) {
        el.hidden = el.getAttribute("data-group") !== name;
      });
    });
  });
})();
