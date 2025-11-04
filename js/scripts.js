(function () {
  try {
    var p = location.pathname;
    if (p && p.endsWith('.html')) {
      var clean = p.replace(/\.html$/, '/');
      history.replaceState(null, '', clean + location.search + location.hash);
    }
  } catch (e) {
    // Silently ignore errors to avoid breaking the page
  }
})();