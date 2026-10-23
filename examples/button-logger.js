// ==Banan==
// @name        Button Logger
// @version     1.0.0
// @author      Nyxi
// @description Harmony-style patch example: logs every UI button click, and can block them.
// @game        *
// ==/Banan==

module.exports = class ButtonLogger extends Banan {
  onInitializeBanan() {
    this.block = this.pref('block', false, 'Block button clicks', { description: 'A prefix that returns false skips the original method.' });

    // UnityEngine.UI.Button.OnPointerClick is called by the EventSystem through an
    // interface, so it goes through the function table and can be patched.
    this.patch('UnityEngine.UI.Button::OnPointerClick', {
      prefix: (ctx) => {
        const button = ctx.instance;               // `this` as an Il2Cpp proxy
        this.logger.msg(`Clicked: ${button.gameObject.name}`);
        if (this.block.value) {
          this.logger.warn('...blocked');
          return false;                            // skip the original
        }
        return true;
      },
    });
  }
};
