(function () {
  "use strict";

  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasGsap = !!(window.gsap && window.ScrollTrigger);
  var animate = hasGsap && !prefersReducedMotion;

  /* ---- Footer year ---- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---- Sticky header ---- */
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

  /* ---- Active nav link on scroll (only sections with a nav entry) ---- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".nav-link"));
  var linkedIds = navLinks.map(function (l) { return l.getAttribute("href").replace("#", ""); });
  var linkedSections = linkedIds
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);

  if (linkedSections.length && "IntersectionObserver" in window) {
    var sectionObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var id = entry.target.getAttribute("id");
          navLinks.forEach(function (link) {
            link.classList.toggle("is-active", link.getAttribute("href") === "#" + id);
          });
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    linkedSections.forEach(function (s) { sectionObserver.observe(s); });
  }

  /* ---- Hero video: pause off-screen, respect reduced motion ---- */
  var heroVideo = document.getElementById("heroVideo");
  if (heroVideo) {
    if (prefersReducedMotion) {
      heroVideo.removeAttribute("autoplay");
      heroVideo.pause();
    } else if ("IntersectionObserver" in window) {
      var videoObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) heroVideo.play().catch(function () {});
            else heroVideo.pause();
          });
        },
        { threshold: 0.15 }
      );
      videoObserver.observe(heroVideo);
    }
  }

  /* ---- Fallback reveal (no GSAP / reduced motion): everything just stays visible ---- */
  if (!animate) return;

  document.documentElement.classList.add("js-anim");
  gsap.registerPlugin(ScrollTrigger);

  /* Line-mask reveals (headline / statement lines) */
  document.querySelectorAll("[data-reveal-line]").forEach(function (mask) {
    var inner = mask.querySelector("span");
    if (!inner) return;
    gsap.set(inner, { yPercent: 110 });
    gsap.to(inner, {
      yPercent: 0,
      duration: 1.1,
      ease: "power4.out",
      scrollTrigger: { trigger: mask, start: "top 92%", once: true },
    });
  });

  /* Generic fade-up reveals, grouped per closest section for stagger */
  document.querySelectorAll(".hero, .section, .cta-final").forEach(function (section) {
    var items = section.querySelectorAll(":scope [data-reveal]");
    if (!items.length) return;
    gsap.set(items, { opacity: 0, y: 26 });
    gsap.to(items, {
      opacity: 1,
      y: 0,
      duration: 0.9,
      ease: "power3.out",
      stagger: 0.1,
      scrollTrigger: { trigger: section, start: "top 75%", once: true },
    });
  });

  /* Image un-scale reveal for cards/gallery */
  document.querySelectorAll("[data-reveal-img] img").forEach(function (img) {
    gsap.to(img, {
      scale: 1,
      duration: 1.3,
      ease: "power3.out",
      scrollTrigger: { trigger: img, start: "top 85%", once: true },
    });
  });

  /* Hero video: slow scale on scroll, laser stays the focal point */
  if (heroVideo) {
    gsap.to(heroVideo, {
      scale: 1.1,
      ease: "none",
      scrollTrigger: {
        trigger: ".hero",
        start: "top top",
        end: "bottom top",
        scrub: true,
      },
    });
  }

  /* Service rows: subtle parallax stagger already covered by fade-up; add index fade */
  gsap.utils.toArray(".service-index").forEach(function (el, i) {
    gsap.from(el, {
      opacity: 0,
      duration: 0.6,
      delay: i * 0.03,
      scrollTrigger: { trigger: el, start: "top 90%", once: true },
    });
  });
})();
