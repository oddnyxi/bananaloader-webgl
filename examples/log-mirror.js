// ==Banan==
// @name        Unity Log Mirror
// @version     1.0.0
// @author      Nyxi
// @description Plugin example: copies the game's Debug.Log output into the BananaLoader console.
// @type        plugin
// @game        *
// ==/Banan==

// Unity WebGL prints Debug.Log through console.log / console.warn / console.error,
// so wrapping those is enough. Plugins run onPreInitialize before the game's code
// starts, so even the first engine logs are caught.
module.exports = class LogMirror extends BananPlugin {
  onPreInitialize() {
    const unity = BananaLoader.logger('Unity', '#8a8a96');
    this.orig = {};
    for (const [fn, level] of [['log', 'msg'], ['warn', 'warning'], ['error', 'error']]) {
      const orig = (this.orig[fn] = console[fn]);
      console[fn] = function (...args) {
        // BananaLoader's own lines start with "%c[" — don't mirror those back
        if (!(typeof args[0] === 'string' && args[0].startsWith('%c['))) {
          const text = args.map(String).join(' ').trim();
          if (text) unity[level](text);
        }
        return orig.apply(console, args);
      };
    }
  }

  onDeinitializeBanan() {
    Object.assign(console, this.orig);
  }
};
