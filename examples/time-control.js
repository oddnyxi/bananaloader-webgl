// ==Banan==
// @name        Time Control
// @version     1.0.0
// @author      Nyxi
// @description Slow down, speed up or pause the game with a slider and hotkeys.
// @game        *
// ==/Banan==

module.exports = class TimeControl extends Banan {
  onInitializeBanan() {
    this.Time = Il2Cpp.type('UnityEngine.Time');
    this.speed = this.pref('speed', 1, 'Game speed', { min: 0, max: 4, step: 0.05, description: 'Time.timeScale' });
    this.speed.onChange((v) => this.apply(v));

    this.onKey('F9', () => { this.speed.value = this.speed.value === 0 ? 1 : 0; this.notify(this.speed.value ? 'Resumed' : 'Paused'); });
    this.onKey('Ctrl+ArrowUp', () => { this.speed.value = Math.min(4, +(this.speed.value + 0.25).toFixed(2)); });
    this.onKey('Ctrl+ArrowDown', () => { this.speed.value = Math.max(0, +(this.speed.value - 0.25).toFixed(2)); });
    this.apply(this.speed.value);
  }

  apply(v) {
    try {
      this.Time.timeScale = v;
      this.logger.msg(`timeScale = ${v}`);
    } catch (e) {
      this.logger.error(`Time.timeScale is not available in this build: ${e.message}`);
    }
  }

  onDeinitializeBanan() {
    try { this.Time.timeScale = 1; } catch (_) { /* ignore */ }
  }
};
