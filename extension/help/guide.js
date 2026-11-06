// Click-to-zoom for the screenshots on the help page.
"use strict";
(function () {
  const lb = document.getElementById("lightbox");
  const lbImg = lb.querySelector("img");
  document.querySelectorAll(".shot").forEach((img) => {
    img.addEventListener("click", () => {
      lbImg.src = img.src;
      lbImg.alt = img.alt;
      lb.classList.add("open");
    });
  });
  lb.addEventListener("click", () => lb.classList.remove("open"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") lb.classList.remove("open");
  });
})();
