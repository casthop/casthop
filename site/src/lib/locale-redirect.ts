export const localeRedirectInline = `(function () {
  var KEY = "casthop.locale";
  var LOCALES = ["en", "pt-BR", "es", "fr", "de", "ja"];
  var current = document.documentElement.getAttribute("data-locale") || "en";
  function isLocale(v) { return LOCALES.indexOf(v) !== -1; }
  function match(tag) {
    var lower = String(tag || "").toLowerCase().replace(/_/g, "-");
    if (lower === "pt-br" || lower.indexOf("pt-br-") === 0 || lower === "pt" || lower.indexOf("pt-") === 0) return "pt-BR";
    if (lower === "es" || lower.indexOf("es-") === 0) return "es";
    if (lower === "fr" || lower.indexOf("fr-") === 0) return "fr";
    if (lower === "de" || lower.indexOf("de-") === 0) return "de";
    if (lower === "ja" || lower.indexOf("ja-") === 0) return "ja";
    if (lower === "en" || lower.indexOf("en-") === 0) return "en";
    return null;
  }
  function detect() {
    var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    for (var i = 0; i < langs.length; i++) {
      var hit = match(langs[i]);
      if (hit) return hit;
    }
    return "en";
  }
  function strip(pathname) {
    var parts = pathname.split("/").filter(Boolean);
    if (parts[0] && isLocale(parts[0]) && parts[0] !== "en") {
      var rest = parts.slice(1).join("/");
      return rest ? "/" + rest : "/";
    }
    return pathname || "/";
  }
  function withLocale(locale, path) {
    var p = path.charAt(0) === "/" ? path : "/" + path;
    if (locale === "en") return p;
    if (p === "/") return "/" + locale + "/";
    return "/" + locale + p;
  }
  try {
    var saved = localStorage.getItem(KEY);
    if (saved && isLocale(saved)) {
      if (saved !== current) {
        var next = withLocale(saved, strip(location.pathname));
        if (next !== location.pathname) location.replace(next + location.search + location.hash);
      }
    } else if (current !== "en") {
      localStorage.setItem(KEY, current);
    } else {
      var detected = detect();
      localStorage.setItem(KEY, detected);
      if (detected !== "en") {
        var next = withLocale(detected, strip(location.pathname));
        if (next !== location.pathname) location.replace(next + location.search + location.hash);
      }
    }
  } catch (e) {}
})();`;
