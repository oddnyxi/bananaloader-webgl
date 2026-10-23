// ==Banan==
// @name        Scene Tools
// @version     1.0.0
// @author      Nyxi
// @description A library Banan: helpers other Banans can @require.
// @color       #a78bfa
// ==/Banan==

// Library Banans expose `this.api`. Banans that `// @require Scene Tools` load after this one,
// get it from `this.require('Scene Tools')`, and are unloaded and reloaded along with it.

module.exports = class SceneTools extends Banan {
  onInitializeBanan() {
    this.api = {
      version: this.info.version,

      /** Every active GameObject whose name matches a RegExp. */
      active: (re) => Il2Cpp.gameObjects(re).filter((go) => go.activeInHierarchy),

      /** Path of a GameObject in the hierarchy, e.g. "MainMenu/Menu/PlayButton". */
      path: (go) => {
        const parts = [];
        for (let t = go.transform; t; t = t.parent) parts.unshift(t.gameObject.name);
        return parts.join('/');
      },

      /** Count of live objects per component type, for a quick scene summary. */
      census: (types) => Object.fromEntries(types.map((t) => [t, Il2Cpp.findAll(t, 5000).length])),
    };
    this.logger.msg('ready');
  }
};
