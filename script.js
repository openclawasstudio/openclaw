(function () {
  const repoEl = document.getElementById("repo");
  const tsEl = document.getElementById("ts");
  const btn = document.getElementById("btn");
  const msg = document.getElementById("msg");

  // Change this if you fork/rename.
  repoEl.textContent = "openclawasstudio/openclaw";

  const now = new Date();
  tsEl.textContent = now.toISOString();

  btn.addEventListener("click", () => {
    const n = Math.floor(Math.random() * 1000);
    msg.textContent = `Button works ✅ (random=${n})`;
  });
})();
