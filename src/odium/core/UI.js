import './install.js'; // mixes the create*() components into Container
import { THEMES } from '../constants.js';
import * as methods from './ui/index.js';

/**
 * The root object. `new UI().createWindow()` then `ui.addTab('Name').createButton(...)`.
 * Its methods live in ./ui/*.js, one concern per file.
 */
export class UI {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.win = null;
    this.reg = new Map(); // config key -> control handle
    this.keys = [];       // registered hotkeys
    this.accent = THEMES.Odium;
    this._opacity = 1;
    this._lastGroup = undefined;
  }
}

Object.assign(UI.prototype, methods);
