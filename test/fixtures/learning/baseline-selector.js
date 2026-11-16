// Frozen baseline selector, used only with artificial inputs in tests.
module.exports = function(DATA,state) {
  function noise(id) {
    let h = 2166136261 ^ state.roll;
    for (const c of DATA.today + id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return ((h >>> 0) % 10000) / 10000;
  }

  function rank() {
    const { mood, time, kind, safe } = state, wild = 1 - safe;
    const list = kind === "rewatch" ? DATA.rewatch : DATA.films;
    const tonight = new Set(DATA.tonight);
    const out = [];
    for (const x of list) {
      if (state.skipped.has(x.t)) continue;
      if (time && x.r && x.r > time) continue;
      const fits = Object.values(x.f);
      const fit = mood === "tonight" ? (fits.length ? Math.max(...fits) : null) : x.f[mood];
      if (fit == null) continue;
      let s = 1.1 * Math.min(fit, 1.6);
      if (kind === "rewatch") {
        const years = x.last ? (Date.parse(DATA.today) - Date.parse(x.last)) / 31557600000 : 6;
        s += 0.9 * (x.rating - 4) + 0.08 * Math.min(years, 10);
      } else {
        s += (0.45 + 0.7 * safe) * (x.ts || 0) + (0.25 + 0.5 * safe) * (x.q || 0);
        if (x.w) s += 0.4 * safe;
        if (x.pins && x.pins.includes(mood)) s += 1.2;
        if (mood === "tonight" && tonight.has(x.t)) s += 2.5 * safe;
        s += wild * ((x.l && x.l !== "en" ? 0.3 : 0) + (x.vc < 1500 ? 0.35 : 0));
      }
      s += wild * 1.6 * noise(String(x.t));
      out.push({ x, s, fit });
    }
    return out.sort((a, b) => b.s - a.s);
  }


return rank();
};
