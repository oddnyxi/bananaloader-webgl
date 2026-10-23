// ==Banan==
// @name        Hello Banan
// @version     1.0.0
// @author      Nyxi
// @description Shows every lifecycle callback, a preference and a tab. Start here.
// @game        *
// ==/Banan==

module.exports = class HelloBanan extends Banan {
  onPreInitialize() {
    // The game's wasm is loaded but IL2CPP isn't running yet.
    this.logger.msg('onPreInitialize');
  }

  onInitializeBanan() {
    this.logger.msg(`onInitializeBanan: ${BananaLoader.game.product} on Unity ${BananaLoader.game.unity}`);

    // Preferences are saved automatically and show up in the Preferences tab.
    this.greeting = this.pref('greeting', 'Hello from BananaLoader!', 'Greeting', { description: 'Shown by the button below.' });
    this.logScenes = this.pref('logScenes', true, 'Log scene changes');

    // A tab with Odium UI controls.
    const tab = this.createTab('Hello');
    tab.createSection('Hello Banan');
    tab.createButton('Say hi', () => this.notify(this.greeting.value, 'success'));
    tab.createButton('List root GameObjects', () => {
      for (const root of this.unity.hierarchy().roots) this.logger.msg(root.name);
    });
    this.frames = tab.createStat('Frames seen', '0');

    // A keyboard shortcut that works while the game has focus.
    this.onKey('F6', () => this.notify('F6 pressed in Hello Banan'));
  }

  onLateInitializeBanan() {
    this.logger.msg('onLateInitializeBanan: everything is loaded');
  }

  onSceneWasLoaded(buildIndex, sceneName) {
    if (this.logScenes.value) this.logger.msg(`Scene loaded: ${sceneName} (#${buildIndex})`);
  }

  onSceneWasInitialized(buildIndex, sceneName) {
    if (this.logScenes.value) this.logger.msg(`Scene initialized: ${sceneName}`);
  }

  onUpdate() {
    this.count = (this.count || 0) + 1;
    if (this.count % 30 === 0) this.frames.setValue(String(this.count));
  }

  onDeinitializeBanan() {
    this.logger.msg('Bye! (unloaded or reloaded)');
  }
};
