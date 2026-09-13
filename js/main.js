(function () {
  "use strict";

  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Footer year ---- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---- Sticky header shadow ---- */
  var header = document.getElementById("siteHeader");
  function onScrollHeader() {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 12);
  }
  onScrollHeader();
  window.addEventListener("scroll", onScrollHeader, { passive: true });

  /* ---- Mobile nav toggle ---- */
  var navToggle = document.getElementById("navToggle");
  var mainNav = document.getElementById("mainNav");

  function closeNav() {
    if (!navToggle || !mainNav) return;
    navToggle.setAttribute("aria-expanded", "false");
    mainNav.classList.remove("is-open");
    document.body.style.overflow = "";
  }

  if (navToggle && mainNav) {
    navToggle.addEventListener("click", function () {
      var isOpen = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", String(!isOpen));
      mainNav.classList.toggle("is-open", !isOpen);
      document.body.style.overflow = !isOpen ? "hidden" : "";
    });

    mainNav.addEventListener("click", function (e) {
      if (e.target.matches(".nav-link")) closeNav();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeNav();
    });
  }

  /* ---- Smooth-scroll offset for fixed header (native scroll-behavior handles the rest) ---- */

  /* ---- Active nav link on scroll ---- */
  var sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".nav-link"));

  if (sections.length && navLinks.length && "IntersectionObserver" in window) {
    var sectionObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var id = entry.target.getAttribute("id");
          navLinks.forEach(function (link) {
            var match = link.getAttribute("href") === "#" + id;
            link.classList.toggle("is-active", match);
          });
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    sections.forEach(function (s) { sectionObserver.observe(s); });
  }

  /* ---- Generic fade-up reveal ---- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
  if (revealEls.length) {
    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      revealEls.forEach(function (el) { el.classList.add("in-view"); });
    } else {
      var revealObserver = new IntersectionObserver(
        function (entries, obs) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("in-view");
              obs.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15 }
      );
      revealEls.forEach(function (el) { revealObserver.observe(el); });
    }
  }

  /* ---- Hero video: respect reduced motion, keep paused off-screen ---- */
  var heroVideo = document.getElementById("heroVideo");
  if (heroVideo) {
    if (prefersReducedMotion) {
      heroVideo.removeAttribute("autoplay");
      heroVideo.pause();
    } else if ("IntersectionObserver" in window) {
      var videoObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              heroVideo.play().catch(function () {});
            } else {
              heroVideo.pause();
            }
          });
        },
        { threshold: 0.2 }
      );
      videoObserver.observe(heroVideo);
    }
  }
})();
