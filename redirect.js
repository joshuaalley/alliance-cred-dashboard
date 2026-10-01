// redirect.js — one canonical address for the dashboard.
//
// Old links (joshuaalley.github.io/alliance-cred-dashboard/…, used at the 2026-08 workshop)
// and alternate addresses (*.pages.dev, www.) are sent to https://alliance-credibility.org,
// keeping the page and any ?atopid=… so every old link still lands on the right alliance.
// Local testing (localhost, opening a file directly) is left alone.
// Loaded first in <head> by every page (dashboard/build.sh wires it into the rendered pages).

var CANONICAL_HOST = "alliance-credibility.org";

// returns the URL to send this visitor to, or null to stay put
function canonicalUrl(href) {
  var u = new URL(href);
  var h = u.hostname;
  if (u.protocol === "file:" || !h || h === CANONICAL_HOST || h === "localhost" || h === "127.0.0.1") {
    return null;
  }
  var path = u.pathname;
  // GitHub Pages served the site under /alliance-cred-dashboard/; the domain serves it at /
  if (/\.github\.io$/.test(h)) path = path.replace(/^\/alliance-cred-dashboard(?=\/|$)/, "") || "/";
  return "https://" + CANONICAL_HOST + path + u.search + u.hash;
}

(function () {
  var target = canonicalUrl(location.href);
  if (target) location.replace(target);
})();
