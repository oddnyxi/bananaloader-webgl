// ==Banan==
// @name        Scene Report
// @version     1.0.0
// @author      Nyxi
// @description Logs a summary of every scene that loads. Uses Scene Tools.
// @require     Scene Tools >=1.0.0
// @optional    FPS Overlay
// @color       #38bdf8
// ==/Banan==

module.exports = class SceneReport extends Banan {
  onInitializeBanan() {
    this.tools = this.require('Scene Tools');        // throws if it isn't loaded (it is: @require)
    this.fps = this.optional('FPS Overlay');         // null when that Banan isn't installed
  }

  onSceneWasInitialized(index, name) {
    const counts = this.tools.census(['UnityEngine.Camera', 'UnityEngine.Light', 'UnityEngine.Canvas', 'UnityEngine.Collider']);
    this.logger.msg(`${name} (#${index}):`, Object.entries(counts).map(([t, n]) => `${t.split('.').pop()} ${n}`).join(' · '));
    for (const go of this.tools.active(/Button$/).slice(0, 5)) this.logger.debug('button', this.tools.path(go));
    if (this.fps) this.logger.debug('FPS Overlay is installed too');
  }
};
