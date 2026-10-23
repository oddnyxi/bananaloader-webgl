// ==Banan==
// @name        FPS Overlay
// @version     1.0.0
// @author      Nyxi
// @description Draws FPS, frame time and the current scene in a corner with onGUI.
// @game        *
// ==/Banan==

module.exports = class FpsOverlay extends Banan {
  onInitializeBanan() {
    this.corner = this.pref('corner', 'Top left', 'Corner', { options: ['Top left', 'Top right', 'Bottom left', 'Bottom right'] });
    this.samples = [];
    this.last = performance.now();
  }

  onUpdate() {
    const now = performance.now();
    this.samples.push(now - this.last);
    this.last = now;
    if (this.samples.length > 60) this.samples.shift();
  }

  onGUI(gui) {
    const avg = this.samples.reduce((a, b) => a + b, 0) / (this.samples.length || 1);
    const fps = avg ? Math.round(1000 / avg) : 0;
    const scene = BananaLoader.scenes.map((s) => s.name).join(', ') || '-';
    const w = 190;
    const hgt = 62;
    const right = this.corner.value.includes('right');
    const bottom = this.corner.value.includes('Bottom');
    const x = right ? gui.width - w - 12 : 12;
    const y = bottom ? gui.height - hgt - 12 : 12;
    gui.box(x, y, w, hgt, { stroke: 'rgba(225,29,46,.6)' });
    gui.text(`${fps} FPS`, x + 12, y + 10, { size: 16, weight: 800, color: fps >= 50 ? '#4ade80' : fps >= 30 ? '#fbbf24' : '#f87171' });
    gui.text(`${avg.toFixed(1)} ms`, x + w - 12, y + 13, { align: 'right', color: '#8a8a96' });
    gui.text(scene, x + 12, y + 38, { size: 12, color: '#ececf1' });
  }
};
